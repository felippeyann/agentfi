Full engineering and agent-readiness review below, with findings first and ordered by severity.

Findings

Critical: Hosted MCP endpoint is effectively open and can be used without client authentication.
Evidence: index.ts:145, index.ts:154, index.ts:162, index.ts:68, api-client.ts:10.
Problem: SSE endpoint accepts any connection, CORS is wildcard, and no inbound key check is performed before tool execution.
Impact: Any external caller can potentially drive the MCP server and spend from whichever agent key is configured on that server instance.
Critical: Admin dashboard appears publicly accessible with no operator login/session gate.
Evidence: page.tsx:4, layout.tsx:14, page.tsx:31, api.ts:16.
Problem: App renders admin data server-side and uses the admin secret internally, but there is no user authentication layer in the admin app itself.
Impact: If deployed on a public domain, anyone reaching the app can view operator-level telemetry and trigger admin actions routed through server endpoints.
Critical: Policy controls are not enforced for major transaction routes.
Evidence: Swap calls policy validation at transactions.ts:231, batch does at transactions.ts:682, but transfer/deposit/withdraw routes are defined at transactions.ts:357, transactions.ts:437, transactions.ts:537 without policy checks.
Problem: Core promise of policy-constrained execution is only partially applied.
Impact: Agent can execute transfers/lending actions that bypass intended off-chain policy limits and kill-switch semantics.
Critical: Fee accounting can claim collected fees when no on-chain collection occurred.
Evidence: Executor bypasses zero-value flows at executor.service.ts:115, transfer/deposit/withdraw are not executor-wrapped in transactions.ts:357, transactions.ts:437, transactions.ts:537, but worker records fee events whenever feeAmountWei is positive at transaction.queue.ts:112.
Doc mismatch: Architecture claims fee routed at tx time in architecture.md:47.
Impact: Revenue and accounting integrity risk, and trust/compliance exposure.
Critical: Swap amount parsing assumes 18 decimals for all assets.
Evidence: transactions.ts:182, transactions.ts:226.
Problem: Non-18 tokens like USDC are handled incorrectly.
Impact: Wrong notional amounts, failed trades, or dangerous over-sizing if balances exist.
Critical: Idempotency is globally unique and looked up without agent scoping.
Evidence: Schema unique key at schema.prisma:103, route lookups at transactions.ts:213, transactions.ts:363, transactions.ts:543, transactions.ts:660.
Problem: Returning an existing transaction by shared key can cross tenant boundaries.
Impact: Cross-agent data leakage and unintended dedupe collisions.
High: Agent chain restrictions are stored but not enforced during execution.
Evidence: Agent registration includes chainIds at agents.ts:17, but transaction helper only fetches safeAddress and walletId at transactions.ts:828.
Impact: Agents can submit transactions on chains outside their allowed profile.
High: Safety contract around simulation_id is not enforced backend-side.
Evidence: MCP tool states simulation_id required at swap.ts:78, but backend swap schema has no simulation_id at transactions.ts:137.
Impact: False safety guarantee; caller can skip true bind between pre-sim and execution payload.
High: Production deployment workflow is explicitly not configured.
Evidence: deploy-production.yml:3, deploy-production.yml:22, CHECKLIST.md:230.
Impact: No standardized release gate, rollback path, or production environment automation.
Medium: MCP endpoint path is inconsistent across metadata/docs and server implementation.
Evidence: Well-known advertises /sse at index.ts:72, server actually serves /mcp/sse at index.ts:154, deploy doc shows /sse at DEPLOY.md:175.
Impact: Client integration friction and avoidable connection failures.
Medium: Agent deactivation can fail for agents without policy row.
Evidence: Deactivate route calls emergencyPause at agents.ts:215, emergencyPause uses strict update at policy.service.ts:122.
Impact: Operational kill/deactivate flow can fail in real incidents.
Medium: Batch policy value conversion uses Number on bigint.
Evidence: transactions.ts:681.
Impact: Precision loss for large values and possible policy bypass around max-per-tx checks.
Open Questions

Is the hosted MCP intended to be multi-tenant, or one isolated deployment per agent/operator?
Is current fee strategy intentionally hybrid (on-chain for ETH value only, off-chain invoicing for ERC-20), or should all fee events represent actually collected funds only?
Is the admin panel expected to be private-network only, or internet-facing with operator authentication?
What Is Left For Professional Go-Live

P0 security and trust blockers
Add strict authentication and authorization on MCP transport ingress, not only backend egress.
Add real admin authentication (OIDC/session/MFA) and restrict admin API exposure.
Enforce policy checks uniformly on swap/transfer/deposit/withdraw/batch.
Fix token decimal handling by resolving token decimals before parseUnits in swap/simulate.
Scope idempotency by agentId plus idempotencyKey composite key.
Align fee events with actual collection state, or separate estimated vs collected ledgers.
P0 correctness blockers
Enforce chain allowlist on every transaction route.
Enforce simulation_id binding (hash payload + chain + amount + deadline) between simulate and execute.
Fix MCP endpoint consistency across docs, well-known metadata, and runtime routes.
P1 production hardening
Stand up production deployment pipeline/environment with promotion flow, rollback, and release approvals.
Add explicit alerting/SLOs for queue latency, failed confirmations, simulation failures, and fee reconciliation drift.
Add incident runbooks for compromised agent key, RPC outage, Redis outage, and webhook replay/failure.
P1 test expansion
Add API-level integration tests for auth boundaries, policy enforcement per route, and idempotency isolation.
Add adversarial tests for malformed batch actions and large bigint values.
Add reconciliation tests ensuring on-chain fee transfer equals ledgered collected fee.
P2 agent-native future readiness
Add scoped capability tokens for agents (tool-level permissions, expiry, revocation).
Add deterministic policy attestations in transaction receipts/logs for auditability.
Add multi-agent isolation guarantees for MCP sessions and backend tenancy boundaries.
Future Scenario Risks To Plan For

Prompt-injected agent attempts unrestricted batch calldata to non-whitelisted targets.
Shared MCP endpoint abuse by unauthorized clients.
Volume spike plus RPC degradation causing stuck queue and stale confirmations.
Billing disputes when ledgered fees are not provably collected on-chain.
Public admin endpoint scraping and operational intelligence leakage.
Validation Performed

Typecheck ran successfully across all workspaces.
Backend unit tests passed: 37 passing.
Contract tests passed: 106 passing total across AgentExecutor and AgentPolicyModule suites.
Backend e2e tests were not executed in this pass.

Decisions resolved and execution started

- MCP tenancy model: single-tenant per deployment (v1), with authenticated SSE ingress.
- Fee model: FeeEvent now represents collected revenue only; usage counting tracked independently.
- Admin access model: local-only by default, with explicit remote opt-in.

Execution log document:

- docs/railway_logs/REMEDIATION_PLAN_EXECUTION_2026-04-01.md