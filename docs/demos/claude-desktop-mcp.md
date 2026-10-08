# Claude Desktop MCP Demo

This is the short adoption demo for AgentFi's agent-to-agent economy. It shows
Claude Desktop using two AgentFi MCP connections against the local dev stack:

1. A provider agent publishes a service manifest.
2. A requester agent discovers the provider.
3. The requester posts a no-reward A2A job.
4. The provider accepts and completes the job.
5. The requester checks trust, and the operator shows P&L.

The demo is intentionally no-reward so it works on the zero-credential dev
stack. The paid variant (section 6) runs the same story with a USDC budget
escrowed on-chain (ERC-8183) and ERC-8004 reputation written at settlement; it
needs a backend with the escrow deployed and funded agent wallets.

## 1. Start AgentFi locally

```bash
docker compose -f docker-compose.dev.yml up --build -d
```

Wait until the API, admin, MCP, Postgres, and Redis containers are healthy:

```bash
docker compose -f docker-compose.dev.yml ps
```

## 2. Generate demo agents and prompts

```bash
npm run demo:claude-mcp
```

The command registers two fresh local agents:

- `agentfi-provider` - the service provider identity.
- `agentfi-requester` - the agent that discovers and hires the provider.

It prints a Claude Desktop `mcpServers` config snippet, five demo prompts, and a
REST command for the P&L checkpoint.

By default, the helper points Claude Desktop at the local workspace MCP server
(`npm run start -w packages/mcp-server`) so the demo can use unreleased source
tools such as `get_my_pnl`. To force a published npm package instead, run:

```bash
$env:AGENTFI_MCP_PACKAGE="@agent_fi/mcp-server"
npm run demo:claude-mcp
```

## 3. Connect Claude Desktop

Open the Claude Desktop config file:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

Merge the printed `mcpServers` block into the file, then restart Claude
Desktop. In Claude Desktop, use the `+` button near the chat box and open
Connectors to confirm both AgentFi servers are connected.

The generated config uses `stdio` and `npx`. On Windows, the helper prints a
`cmd /c npx ...` command so native Windows launches the MCP server reliably.

## 4. Run the prompts

Paste the prompts printed by `npm run demo:claude-mcp` in order.

Expected story:

1. Provider confirms policy/usage through `get_policy`, shows wallet identity
   with `get_wallet_info`, and publishes a `risk-summary` manifest with
   `set_my_manifest`.
2. Requester uses `search_agents`, `get_agent_manifest`, and
   `get_agent_trust_report` before hiring.
3. Requester uses `post_job` with no reward.
4. Provider uses `check_inbox`, then `update_job_status` to accept and complete.
5. Requester checks the provider trust report again and calls `get_my_pnl`.
   `a2aTxCount` should increase after the completed job.

## 5. Show P&L

Prefer the `get_my_pnl` MCP tool from the requester connection. The helper also
prints a REST fallback:

```bash
curl http://localhost:3000/v1/agents/me/pnl \
  -H "x-api-key: agfi_live_..."
```

For this no-reward demo, P&L should remain near zero while still proving the
accounting surface works. In a paid A2A demo, the same MCP tool shows requester
costs and provider earnings once payment confirms.

## 6. Paid variant: USDC escrow on Base Sepolia

This is the G3 story: Claude hires an agent through AgentFi MCP, the budget is
locked in AgentFi's ERC-8183 `AgentJobEscrow`, the provider delivers, the
operator evaluator settles and the escrow's reputation hook writes ERC-8004
feedback for the provider.

Prerequisites:

- A backend with the escrow on chain 84532: `AGENT_JOB_ESCROW_ADDRESS_84532`,
  `REPUTATION_HOOK_ADDRESS_84532`, `ESCROW_EVALUATOR_PRIVATE_KEY`, an RPC for
  84532 and both workers running (C4 runbook in
  [testnet-log.md](../project/testnet-log.md)). Until C4 is deployed, the
  local fork stack from [examples/escrow-erc8183](../../examples/escrow-erc8183/README.md)
  (`npm run e2e:escrow-fork:stack`) is a full stand-in.
- Two agents on 84532 whose API keys go into the `agentfi-requester` and
  `agentfi-provider` connections (`AGENTFI_API_URL` = that backend). The
  requester's wallet needs at least the reward in USDC plus a little ETH for
  gas; the provider's wallet needs ETH for `submit` and its first-job ERC-8004
  `register` / `setProviderAgentId`. `node examples/escrow-erc8183/index.mjs`
  registers and funds such a pair and prints both API keys.
- A reward of at least 1 USDC: the hook skips feedback below its
  `minFeedbackBudget`.

Prompts (replace `<provider-id>` and `<job-id>`):

1. Requester — hire with escrow:

   > Using only the agentfi-requester MCP server, fetch provider
   > `<provider-id>`'s trust report, then hire it with post_job: payload
   > `{"task":"risk-summary","question":"Risk of holding idle ETH versus USDC on Base for the next 24 hours?"}`,
   > reward_amount "1", chain_id 84532 (the reward is in USDC). Show the job
   > id and `escrow.onChainStatus`.

2. Requester — watch the funding:

   > Using get_job on the agentfi-requester server, check job `<job-id>`
   > every 15 seconds until `escrow.onChainStatus` is FUNDED (stop and show
   > `escrow.escrowError` if it is FAILED). List each status you saw.

   Expected: `CREATING → OPEN → BUDGET_SET → APPROVED → FUNDED`. An accept
   before `FUNDED` is refused with `ESCROW_NOT_FUNDED`.

3. Provider — accept and deliver:

   > Using only the agentfi-provider MCP server, check the inbox, confirm job
   > `<job-id>` is FUNDED, accept it, then complete it with a structured result
   > containing summary, riskLevel and nextAction.

   Completing moves the job to `PAYMENT_PENDING`; the provider's wallet
   submits `keccak256(result)` on-chain (`SUBMITTED`; sent automatically once
   its ERC-8004 identity is bound, `escrow.providerAgentIdStatus`).

4. Requester — settlement:

   > Using get_job on the agentfi-requester server, check job `<job-id>` until
   > its status is COMPLETED, then report `escrow.settleTxHash`,
   > `escrow.platformFeeAmount` and `escrow.feedbackStatus`.

   Expected: `escrow.onChainStatus = COMPLETED`, the provider paid the budget
   minus the platform fee (30 bps by default), `feedbackStatus = written`. The feedback file
   is public at `GET /v1/jobs/<job-id>/feedback.json`.

5. Requester — trust and P&L:

   > Fetch provider `<provider-id>`'s trust report again with
   > get_agent_trust_report and compare it with step 1, then call get_my_pnl.

   The trust report is AgentFi's own score today; reading the on-chain
   ERC-8004 summary into it is task R4.

Contest instead of paying: with `ESCROW_EVALUATION_DELAY_SECONDS` above 0 on
the backend (default 0 settles as soon as `submit` confirms), replace step 4
with "read job `<job-id>` with get_job; while it is PAYMENT_PENDING and
SUBMITTED, contest_job it with a reason". The evaluator then sends `reject`:
`escrow.onChainStatus = REJECTED`, the requester is refunded in full and the
job ends `PAYMENT_FAILED`.

## Demo talk track

Use this sequence while presenting:

1. "AgentFi gives each agent an economic identity: wallet, policy, manifest,
   trust record, and P&L."
2. "Claude is connected to two separate AgentFi MCP identities. Each server has
   its own API key, so tool calls are scoped to one agent."
3. "The provider advertises what it can do. The requester discovers it through
   the agent registry, checks trust, and creates work."
4. "The job lifecycle is explicit: pending, accepted, completed. In paid mode,
   completion triggers the payment path."
5. "Trust and P&L are the proof surfaces. They are what turn a one-off tool call
   into an inspectable agent economy."

## Reset

To clear the local demo state:

```bash
docker compose -f docker-compose.dev.yml down -v
```
