# AgentFi Remediation Plan and Execution

Date: 2026-04-01
Owner: Codex (execution pass)

## Deterministic Decisions

1. MCP tenancy model
- Decision: single-tenant MCP deployment per operator/agent key for v1.
- Rationale: strongest isolation with lowest operational/security complexity.
- Future path: multi-tenant MCP only after per-session identity and tenant isolation tests are in place.

2. Fee accounting model
- Decision: FeeEvent must represent collected revenue only.
- Rationale: financial/audit integrity. No mixing of estimated and collected values.
- Future path: if needed, add a separate accrued_fee ledger for non-on-chain collection models.

3. Admin access model
- Decision: local-only by default, explicit remote opt-in.
- Rationale: secure operations now, remote operation later by intentional configuration.
- Toggle: ADMIN_ALLOW_REMOTE=true enables remote admin.

## P0 Remediation Plan

1. Security hardening
- Lock hosted MCP ingress with API key auth.
- Restrict admin endpoints to loopback by default.
- Restrict admin frontend to loopback by default.

2. Transaction correctness
- Enforce chain allowlist for all transaction routes.
- Enforce simulationId presence for swap execution.
- Fix swap token decimal handling (no 18-decimal assumption).
- Scope idempotency behavior to agent context (prevent cross-agent leakage).
- Enforce policy checks on transfer/deposit/withdraw in addition to swap/batch.

3. Revenue and billing integrity
- Track tx usage independently from fee collection.
- Only write FeeEvent when fee is collected on-chain via executor routing.

## Execution Status

Completed in this pass:
- MCP SSE authentication + CORS hardening.
- Backend well-known MCP endpoint path alignment.
- Admin backend local-only gate with remote opt-in.
- Admin frontend middleware local-only gate with remote opt-in.
- Environment docs updated with AGENTFI_API_KEY, MCP_CORS_ORIGIN, ADMIN_ALLOW_REMOTE.
- Swap route now requires simulationId and resolves input token decimals.
- Chain allowlist enforcement added across transaction routes.
- Idempotency conflict behavior changed to prevent cross-agent data exposure.
- Policy checks added for transfer, deposit, withdraw.
- Batch ETH value conversion fixed to bigint-safe decimal conversion.
- FeeEvent semantics changed to collected-on-chain only.
- Tx usage counting decoupled from FeeEvent and tracked on all confirmed tx.

Still recommended next (P1/P2):
- Add composite DB uniqueness (agentId + idempotencyKey) via migration.
- Add API integration tests for auth boundaries and idempotency collisions.
- Add accrued-vs-collected dual ledger if off-chain settlement is reintroduced.
- Add full operator auth (OIDC/session/MFA) for intentional remote admin operation.
- Build production Railway deploy promotion workflow with rollback playbook.
