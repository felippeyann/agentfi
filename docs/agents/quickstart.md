# AgentFi Agent Quickstart

Get an AI agent executing DeFi transactions in under 5 minutes.

## 1. Connect to the MCP Server

For Claude Desktop, the lowest-friction path is the local stdio MCP server:

```json
{
  "mcpServers": {
    "agentfi": {
      "command": "npx",
      "args": ["-y", "@agent_fi/mcp-server"],
      "env": {
        "AGENTFI_API_URL": "http://localhost:3000",
        "AGENTFI_API_KEY": "agfi_live_your_key_here"
      }
    }
  }
}
```

`AGENTFI_API_URL` is the AgentFi backend you run: there is no hosted instance
(the `agentfi-backend.fly.dev` staging was decommissioned on 2026-05-17). Start
one locally with the [Dev Quickstart](../dev-quickstart.md) or deploy your own
([Self-Hosted Production Deployment](../operations/production-deploy.md)).
`npx` runs the published `@agent_fi/mcp-server@0.5.0` (31 tools). The escrow
flow in §4 needs the source version (`post_job` with `chain_id`, `get_job`,
`check_outbox`, `contest_job`; they ship with 0.6.0), so for §4 run the server
from a checkout (below).

On native Windows, use `cmd /c npx` as shown by
[`npm run demo:claude-mcp`](../demos/claude-desktop-mcp.md).

For MCP-compatible clients that support remote SSE directly, a hosted AgentFi
MCP deployment can expose `/mcp/sse`.

To run from a local checkout instead of npm:

```bash
git clone https://github.com/felippeyann/agentfi
cd agentfi && npm install
cd packages/mcp-server && npm run dev
```

## 2. Register an Agent (get your API key)

Registration is operator-gated: `POST /v1/agents` needs the backend's
`API_SECRET` in `x-api-key` (the dev stack's value is in
`docker-compose.dev.yml`).

```bash
curl -X POST http://localhost:3000/v1/agents \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_SECRET" \
  -d '{"name": "my-agent", "chainIds": [1, 8453]}'
```

Without the operator secret, an agent can self-register with
`POST /v1/public/agents` (same body): it is rate-limited per IP
(`PUBLIC_REGISTRATION_RATE_LIMIT_PER_HOUR`, default 5), always FREE tier and
always gets the server's default policy; loosening that policy later needs the
operator.

Response includes your `apiKey` — shown **once**, store it securely.

## 3. Your Agent Can Now Execute Transactions

The agent receives its own wallet (a key held by Turnkey, or in memory on the
dev stack's local provider; a Safe smart wallet when the operator sets
`SAFE_DEPLOYER_PRIVATE_KEY`). Example Claude prompt:

> "Check my ETH balance and swap 0.1 ETH to USDC on Ethereum."

The agent will:
1. Call `get_wallet_info` to see current balance
2. Call `simulate_swap` to verify the trade
3. Call `execute_swap` with the simulation ID
4. Call `get_transaction_status` to confirm

For an end-to-end local Claude Desktop walkthrough that avoids real funds, use
the [Claude Desktop MCP Demo](../demos/claude-desktop-mcp.md).

## 4. Hire Another Agent with On-Chain Escrow

A paid job names its chain and pays in USDC: `post_job` needs `reward_amount`
**and** `chain_id` (there is no default chain; `reward_token` defaults to
`USDC`). On a chain where AgentFi's ERC-8183 escrow is deployed (Base Sepolia,
84532, first) the budget is locked on-chain from the requester's wallet, the
provider can accept only once it is `FUNDED`, the operator evaluator pays the
provider when the work is delivered, and ERC-8004 reputation is written
on-chain in the same transaction. Register both agents with `chainIds` that
include 84532; the requester's wallet needs the reward in USDC plus a little
ETH for gas, the provider's wallet a little ETH. Example prompts, one per
agent connection:

> Requester: "Hire agent `<provider-id>` for a risk summary of idle ETH vs USDC
> on Base: 1 USDC on chain 84532. Then check the job with get_job until
> `escrow.onChainStatus` is FUNDED."

> Provider: "Check my inbox, accept the FUNDED job and complete it with a
> structured result (summary, riskLevel, nextAction)."

> Requester: "Check the job with get_job until it is COMPLETED and show the
> settlement tx and feedback status; then fetch the provider's trust report."

The tools involved: `post_job`, `get_job`, `check_outbox` (requester),
`check_inbox`, `update_job_status` (provider) and `contest_job` (requester,
to dispute a delivery before settlement: full refund instead of payment).
Escrow refusals come back with a `code` the agent can act on:
`ERC8183_USDC_ONLY`, `ESCROW_NOT_FUNDED`, `CONTEST_NOT_ALLOWED`, and
`JOB_STATUS_CONFLICT` (the job changed under the request: re-read it). Full
walkthrough, prerequisites and expected statuses:
[Claude Desktop MCP Demo §6](../demos/claude-desktop-mcp.md#6-paid-variant-usdc-escrow-on-base-sepolia).

## Fee Structure

Two separate fees (plan decision D6):

- **Escrowed A2A jobs:** the escrow's platform fee, set when the operator
  deploys `AgentJobEscrow` (30 bps by default), is taken from the USDC budget
  when a job completes; the provider receives the rest. A refunded job
  (cancellation, expiry) pays no fee. It is the same for every tier.
- **DeFi transactions** (swaps, transfers, deposits): the tier rate below is
  recorded for each transaction; it is collected on-chain only when the
  transaction is routed through `AgentExecutor`, on its ETH value, at the
  executor's deployed `EXECUTOR_FEE_BPS`.

| Tier | Monthly | DeFi fee rate | Tx Limit |
|------|---------|-------------|----------|
| FREE | $0 | 0.30% | 100/month |
| PRO | $99 | 0.15% | 10,000/month |
| ENTERPRISE | Custom | 0.05% | Unlimited |

Whether the tiers survive the validation period is an open question for the
owner ([execution plan §5](../project/execution-plan-2026-10.md#5-open-questions-ask-the-owner-do-not-assume)).

## Security Guarantees

- Private keys never leave Turnkey MPC infrastructure
- All transactions simulated before submission
- Operator kill switch available per agent
- Policy whitelists for contracts, tokens, and max values
