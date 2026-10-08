/**
 * MCP tool annotations — the single reviewed table of behaviour hints for
 * every tool this server registers (MCP spec 2025-11-25, `Tool.annotations`;
 * field names and defaults as in `ToolAnnotationsSchema` of
 * @modelcontextprotocol/sdk 1.29).
 *
 * Hints are advisory: clients use them to decide what to auto-approve and
 * what to confirm with a human, and MUST treat them as untrusted unless the
 * server is trusted. So when in doubt the table errs towards "ask a human":
 * anything that moves funds, signs, or publishes is not read-only.
 *
 * Classification rules (one line of justification per tool below):
 * - readOnlyHint: true only when the tool changes nothing — no funds, no
 *   signature, no record another party can see. Read-only tools also carry
 *   destructiveHint false / idempotentHint true (the spec ignores both when
 *   readOnlyHint is true; they are set explicitly so no client falls back to
 *   the spec defaults destructive=true / idempotent=false).
 * - destructiveHint: true when the call moves or commits funds, or overwrites
 *   state the agent cannot simply restore (whitelists, the published manifest).
 * - idempotentHint: true only when repeating the SAME arguments can never have
 *   an additional effect. Fund-moving tools are false even where the backend
 *   happens to dedupe some retries, because clients may auto-retry
 *   idempotent tools.
 * - openWorldHint: true when the tool reaches outside the agent's own AgentFi
 *   records — a blockchain (RPC read or transaction), a third-party HTTP API
 *   (CoinGecko, The Graph, x402 resources, the Turnkey signer) or another
 *   agent (paying, hiring, publishing to, or reading content written by one).
 *   false only for reads of the calling agent's own AgentFi records.
 *
 * This module has no runtime dependencies (the SDK import is type-only), so
 * the backend's tests can load it to keep the backend MCP surface in step.
 */
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

/** Every tool carries a display title and all four hints explicitly. */
export type AgentFiToolAnnotations = ToolAnnotations & {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
};

/** Reads only the calling agent's own AgentFi records. */
const READ_OWN_RECORDS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

/** Reads a chain, a third-party API, or data written by other agents. */
const READ_OPEN_WORLD = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

/** Moves or commits funds on-chain; a repeat is a second payment/trade. */
const MOVES_FUNDS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const;

export const TOOL_ANNOTATIONS = {
  // ── wallet ────────────────────────────────────────────────────────────
  // Balances are read from chain RPCs.
  get_wallet_info: { title: 'Get wallet address and balances', ...READ_OPEN_WORLD },
  // Price comes from CoinGecko.
  get_token_price: { title: 'Get token USD price', ...READ_OPEN_WORLD },

  // ── swaps ─────────────────────────────────────────────────────────────
  // eth_call simulation on chain; only caches a short-lived simulation id
  // that execute_swap requires — no funds, no transaction.
  simulate_swap: { title: 'Simulate a Uniswap swap', ...READ_OPEN_WORLD },
  // Sells tokens on Uniswap. The simulation id stays valid for 10 minutes and
  // is not consumed, so repeating the call swaps again.
  execute_swap: { title: 'Execute a Uniswap swap', ...MOVES_FUNDS },

  // ── DeFi ──────────────────────────────────────────────────────────────
  // Sends ETH/ERC-20 out of the wallet.
  transfer_token: { title: 'Transfer tokens', ...MOVES_FUNDS },
  // Moves funds into Aave.
  deposit_aave: { title: 'Supply to Aave V3', ...MOVES_FUNDS },
  // On-chain withdrawal that changes the position; a repeat withdraws again.
  withdraw_aave: { title: 'Withdraw from Aave V3', ...MOVES_FUNDS },
  // Moves funds into Compound.
  supply_compound: { title: 'Supply to Compound V3', ...MOVES_FUNDS },
  // On-chain withdrawal; a repeat withdraws again.
  withdraw_compound: { title: 'Withdraw from Compound V3', ...MOVES_FUNDS },
  // Moves funds into a caller-chosen ERC-4626 vault.
  deposit_erc4626: { title: 'Deposit into ERC-4626 vault', ...MOVES_FUNDS },
  // On-chain withdrawal; a repeat withdraws again.
  withdraw_erc4626: { title: 'Withdraw from ERC-4626 vault', ...MOVES_FUNDS },
  // Swaps on a caller-chosen Curve pool.
  swap_curve: { title: 'Swap on Curve', ...MOVES_FUNDS },
  // Aave rates come from The Graph.
  get_defi_rates: { title: 'Get Aave V3 rates', ...READ_OPEN_WORLD },

  // ── GMX ───────────────────────────────────────────────────────────────
  // Static list compiled into this server; no network call.
  list_gmx_markets: { title: 'List GMX V2 markets', ...READ_OWN_RECORDS },
  // Posts collateral and opens a leveraged position.
  open_gmx_position: { title: 'Open GMX V2 position', ...MOVES_FUNDS },
  // Closes (part of) a leveraged position; a repeat closes more.
  close_gmx_position: { title: 'Close GMX V2 position', ...MOVES_FUNDS },

  // ── status ────────────────────────────────────────────────────────────
  // Reads the agent's own transaction record from the AgentFi DB.
  get_transaction_status: { title: 'Get transaction status', ...READ_OWN_RECORDS },
  // Reads the agent's own policy and usage from the AgentFi DB.
  get_policy: { title: 'Get my policy and limits', ...READ_OWN_RECORDS },

  // ── agent / A2A ───────────────────────────────────────────────────────
  // Reads the agent's own AgentFi record.
  get_my_agent_profile: { title: 'Get my agent profile', ...READ_OWN_RECORDS },
  // P&L is priced in USD through CoinGecko.
  get_my_pnl: { title: 'Get my profit and loss', ...READ_OPEN_WORLD },
  // Returns other agents' self-chosen names and addresses.
  search_agents: { title: 'Search agents', ...READ_OPEN_WORLD },
  // Sends funds to another agent.
  pay_agent: { title: 'Pay another agent', ...MOVES_FUNDS },
  // Tightens the agent's own policy. Not read-only and destructive: it
  // replaces limits/whitelists and the agent cannot undo it (loosening needs
  // the operator). Idempotent: the same values again leave the same policy.
  // Closed world: only the agent's own policy record changes.
  update_policy: {
    title: 'Tighten my policy',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  // Replaces the published manifest that other agents read. Destructive: the
  // previous manifest is overwritten. Idempotent: the same manifest again
  // changes nothing. Open world: the manifest is published to other agents.
  set_my_manifest: {
    title: 'Publish my service manifest',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  // Content written by another agent.
  get_agent_manifest: { title: "Get another agent's manifest", ...READ_OPEN_WORLD },
  // Reputation metrics and name of another agent.
  get_agent_trust_report: { title: "Get another agent's trust report", ...READ_OPEN_WORLD },
  // Signs the AgentFi handshake envelope (EIP-712, S6) over the agent's
  // message with the agent wallet (Turnkey). Changes no
  // state, but it is NOT read-only: it uses the wallet's signing authority and
  // returns a credential third parties can rely on, so clients should not
  // auto-approve it. Not destructive (overwrites nothing); idempotent (a
  // repeat has no further effect); open world (Turnkey, and the signature is
  // meant for other agents).
  sign_handshake: {
    title: 'Sign a handshake message',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  // Pure verification; may fall back to an EIP-1271 call on chain.
  verify_handshake: { title: "Verify a peer's handshake", ...READ_OPEN_WORLD },
  // Creates a job for another agent; a paid job reserves the reward and, on
  // ERC-8183 chains, escrows it on-chain. Each call creates a new job.
  post_job: { title: 'Hire another agent (post job)', ...MOVES_FUNDS },
  // One job: the other party's payload/result and escrow state mirrored from
  // the chain.
  get_job: { title: 'Get a job', ...READ_OPEN_WORLD },
  // Jobs I posted, with results written by providers and on-chain escrow state.
  check_outbox: { title: 'Check my posted jobs (outbox)', ...READ_OPEN_WORLD },
  // Jobs and payloads written by other agents.
  check_inbox: { title: 'Check my job inbox', ...READ_OPEN_WORLD },
  // COMPLETED on a paid job triggers the reward payment / on-chain submit,
  // CANCELLED/FAILED release escrow. The status-transition guard refuses a
  // duplicate today, but that is not a retry contract — so not idempotent.
  update_job_status: { title: 'Update job status', ...MOVES_FUNDS },
  // Requester disputes a submitted deliverable before settlement. Not
  // read-only; destructive: it flips the settlement from paying the provider
  // to a full refund and records a rejection in the provider's on-chain
  // reputation, and it cannot be withdrawn. Idempotent: the backend's
  // conditional write (contestedAt IS NULL) wins once, so a repeat — with any
  // reason — is a 409 that changes nothing. It moves no funds itself (the
  // evaluator settles). Open world: another agent's payment and the chain.
  contest_job: {
    title: 'Contest a delivered job',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  // Spends the agent's own USDC on an x402 resource. Idempotent server-side
  // per `payment_id`, but `payment_id` is optional and a fresh one is
  // generated when it is omitted — the same arguments without it pay again,
  // so the tool as a whole is not idempotent.
  pay_for_resource: { title: 'Pay for an x402 resource', ...MOVES_FUNDS },
} as const satisfies Record<string, AgentFiToolAnnotations>;

export type AnnotatedToolName = keyof typeof TOOL_ANNOTATIONS;

/**
 * Fallback for a tool missing from the table: the most cautious reading of
 * the spec (may write, may destroy, not idempotent, open world). The
 * annotation-coverage test fails before such a tool can ship; this only
 * guarantees that a gap never advertises a tool as safe.
 */
export const CAUTIOUS_DEFAULT_ANNOTATIONS: Omit<AgentFiToolAnnotations, 'title'> = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
};

export function hasAnnotations(name: string): name is AnnotatedToolName {
  return Object.prototype.hasOwnProperty.call(TOOL_ANNOTATIONS, name);
}

export function annotationsFor(name: string): AgentFiToolAnnotations {
  if (hasAnnotations(name)) return { ...TOOL_ANNOTATIONS[name] };
  return { title: name, ...CAUTIOUS_DEFAULT_ANNOTATIONS };
}
